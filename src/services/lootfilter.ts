/**
 * 掉落过滤管理 (M5): read / toggle / backup / import-export of the game's
 * built-in loot-filter presets (<saveRoot>\*.fltr). The SwitchNoDrop.bat
 * rewrite was dropped — those bats are MDK leftovers whose rule fragments
 * are missing from the pack; this tool manages the game's own preset files
 * instead (see docs/product-plan.md §3.4).
 *
 * Format (verified against the 9 新手 presets on the real machine): UTF-8
 * JSON, 4-space indent, no trailing newline, usually no BOM. Write-back
 * preserves whatever the source file had (BOM / trailing newline) so a
 * toggle round-trips byte-identical except the edited enabled flags.
 * Rule objects have a non-fixed field set — untouched fields survive a
 * parse → patch → serialize round-trip untouched by construction.
 */
import { joinPath, saveRoot, basename, pathExists } from "./paths.js";
import { stripBom, lenientParse } from "./modinfo.js";
import { isGameRunning } from "./saves.js";
import { pickFile } from "./launch.js";

const PRESET_EXT = ".fltr";
const BACKUP_DIR = "_d2rbox_filter_backups";

/** A single filter rule. Field set varies per rule — only these three are
 *  guaranteed to exist; everything else passes through opaquely. */
export interface LootRule {
  name?: unknown;
  enabled?: unknown;
  ruleType?: unknown;
  [key: string]: unknown;
}

export interface PresetFileEntry {
  file: string;
  name: string;
  ruleCount: number;
  enabledCount: number;
  /** epoch ms */
  mtime: number;
  size: number;
}

export interface PresetReadResult {
  name: string;
  rules: LootRule[];
  /** non-null when the file parsed leniently but looks off */
  warning: string | null;
}

export interface PresetBackupEntry {
  name: string;
  mtime: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Name validation (path-escape guard — everything stays inside saveRoot)
// ---------------------------------------------------------------------------

function isLegalSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 128 &&
    s !== "." &&
    s !== ".." &&
    !/[\\/:*?"<>|]/.test(s)
  );
}

/** Legal .fltr file name: a single path segment with the extension. */
export function isValidPresetName(file: string): boolean {
  if (!isLegalSegment(file) || !file.toLowerCase().endsWith(PRESET_EXT)) return false;
  return isLegalSegment(file.slice(0, -PRESET_EXT.length));
}

/** Legal display name for duplicate/rename (becomes "<name>.fltr"). */
export function isValidPresetBaseName(name: string): boolean {
  const trimmed = name.trim();
  return (
    isLegalSegment(trimmed) && !trimmed.toLowerCase().endsWith(PRESET_EXT)
  );
}

const BACKUP_NAME_RE = /^\d{8}-\d{6}(-\d+)?$/;

async function presetPath(file: string): Promise<string> {
  if (!isValidPresetName(file)) {
    throw new Error(`非法预设文件名：${JSON.stringify(file)}`);
  }
  return joinPath(await saveRoot(), file);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function withBom(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + body.length);
  out[0] = 0xef;
  out[1] = 0xbb;
  out[2] = 0xbf;
  out.set(body, 3);
  return out;
}

/** Serialize like the game does: 4-space indent; BOM / trailing newline
 *  match the source file being rewritten. */
function serializePreset(parsed: unknown, hadBom: boolean, hadTrailingNewline: boolean): Uint8Array {
  let text = JSON.stringify(parsed, null, 4);
  if (hadTrailingNewline) text += "\n";
  const body = new TextEncoder().encode(text);
  return hadBom ? withBom(body) : body;
}

function stemOf(file: string): string {
  return basename(file).replace(/\.fltr$/i, "");
}

// ---------------------------------------------------------------------------
// Backups: <saveRoot>\_d2rbox_filter_backups\<file>\<yyyyMMdd-HHmmss[-N]>
// ---------------------------------------------------------------------------

function backupNameNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Copy the current preset file (raw bytes) into its backup store.
 *  Returns the backup name, or null when the file doesn't exist. */
async function backupCurrent(file: string): Promise<string | null> {
  const path = await presetPath(file);
  let bytes: Uint8Array;
  try {
    bytes = await tjs.readFile(path);
  } catch {
    return null;
  }
  const store = joinPath(await saveRoot(), BACKUP_DIR, file);
  await tjs.makeDir(store, { recursive: true });
  let name = backupNameNow();
  for (let i = 2; await pathExists(joinPath(store, name)); i++) {
    name = `${backupNameNow()}-${i}`;
  }
  await tjs.writeFile(joinPath(store, name), bytes);
  return name;
}

export async function listPresetBackups(file: string): Promise<PresetBackupEntry[]> {
  if (!isValidPresetName(file)) {
    throw new Error(`非法预设文件名：${JSON.stringify(file)}`);
  }
  const store = joinPath(await saveRoot(), BACKUP_DIR, file);
  if (!(await pathExists(store))) return [];
  const out: PresetBackupEntry[] = [];
  const d = await tjs.readDir(store);
  for await (const e of d) {
    if (!e.isFile || !BACKUP_NAME_RE.test(e.name)) continue;
    try {
      const st = await tjs.stat(joinPath(store, e.name));
      out.push({
        name: e.name,
        mtime: st.mtim instanceof Date ? st.mtim.getTime() : 0,
        size: st.size,
      });
    } catch {
      /* raced delete */
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Overwrite the preset with a backup's bytes (atomic tmp+rename); the
 *  pre-restore current version is backed up first when it exists. */
export async function restorePresetBackup(
  file: string,
  backupName: string,
): Promise<{ backedUp: string | null; restored: boolean }> {
  if (!isValidPresetName(file)) {
    throw new Error(`非法预设文件名：${JSON.stringify(file)}`);
  }
  if (!BACKUP_NAME_RE.test(backupName)) {
    throw new Error(`非法备份名：${JSON.stringify(backupName)}`);
  }
  const root = await saveRoot();
  const src = joinPath(root, BACKUP_DIR, file, backupName);
  if (!(await pathExists(src))) throw new Error(`备份不存在：${backupName}`);
  const backedUp = await backupCurrent(file);
  const target = joinPath(root, file);
  const tmp = joinPath(root, `${file}.tmp-${Date.now()}`);
  try {
    await tjs.copyFile(src, tmp);
    await tjs.rename(tmp, target);
  } catch (err) {
    await tjs.remove(tmp).catch(() => undefined);
    throw err;
  }
  return { backedUp, restored: true };
}

export async function deletePresetBackup(file: string, backupName: string): Promise<void> {
  if (!isValidPresetName(file)) {
    throw new Error(`非法预设文件名：${JSON.stringify(file)}`);
  }
  if (!BACKUP_NAME_RE.test(backupName)) {
    throw new Error(`非法备份名：${JSON.stringify(backupName)}`);
  }
  const p = joinPath(await saveRoot(), BACKUP_DIR, file, backupName);
  if (!(await pathExists(p))) throw new Error(`备份不存在：${backupName}`);
  await tjs.remove(p, { maxRetries: 3, retryDelay: 200 });
}

// ---------------------------------------------------------------------------
// List / read
// ---------------------------------------------------------------------------

export async function listPresets(): Promise<PresetFileEntry[]> {
  const root = await saveRoot();
  try {
    await tjs.stat(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  const d = await tjs.readDir(root);
  for await (const e of d) {
    if (e.isFile && e.name.toLowerCase().endsWith(PRESET_EXT)) files.push(e.name);
  }
  const out: PresetFileEntry[] = [];
  for (const file of files) {
    const p = joinPath(root, file);
    let size = 0;
    let mtime = 0;
    try {
      const st = await tjs.stat(p);
      size = st.size;
      mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
    } catch {
      continue; // raced delete
    }
    const { name, rules } = await readPreset(file);
    out.push({
      file,
      name,
      ruleCount: rules.length,
      enabledCount: rules.filter((r) => r.enabled === true).length,
      mtime,
      size,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return out;
}

/**
 * Parse a preset. Lenient like modinfo (BOM / trailing commas); a broken
 * file yields warning + empty rules instead of throwing so the UI can
 * surface it without losing the other presets.
 */
export async function readPreset(file: string): Promise<PresetReadResult> {
  const path = await presetPath(file);
  let bytes: Uint8Array;
  try {
    bytes = await tjs.readFile(path);
  } catch {
    throw new Error(`预设文件不存在：${file}`);
  }
  const text = new TextDecoder().decode(bytes);
  const parsed = lenientParse(text);
  const fallbackName = stemOf(file);
  if (!parsed || !Array.isArray(parsed.rules)) {
    return {
      name: fallbackName,
      rules: [],
      warning: "文件不是有效的预设 JSON，无法读取规则（未做任何修改）",
    };
  }
  const rules: LootRule[] = [];
  let skipped = 0;
  for (const r of parsed.rules) {
    if (typeof r === "object" && r !== null) rules.push(r as LootRule);
    else skipped++;
  }
  const name =
    typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : fallbackName;
  const warning =
    skipped > 0 ? `有 ${skipped} 条规则条目无法解析，已被跳过` : null;
  return { name, rules, warning };
}

// ---------------------------------------------------------------------------
// Rule summaries (中文)
// ---------------------------------------------------------------------------

const RULE_TYPE_LABEL: Record<string, string> = {
  hide: "隐藏",
  show: "显示",
  highlight: "高亮",
};

const RARITY_LABEL: Record<string, string> = {
  lowQuality: "低品质",
  normal: "普通",
  hiQuality: "高品质",
  magic: "魔法",
  rare: "稀有",
  set: "套装",
  unique: "暗金",
};

const QUALITY_LABEL: Record<string, string> = {
  normal: "普通",
  exceptional: "扩展",
  elite: "精英",
};

const EQUIP_CATEGORY_LABEL: Record<string, string> = {
  weap: "武器",
  armo: "护甲",
  acce: "首饰",
  amaz: "亚马逊装备",
  assas: "刺客装备",
  barbh: "野蛮人装备",
  druid: "德鲁伊装备",
  necro: "死灵法师装备",
  palad: "圣骑士装备",
  sorce: "法师装备",
  warlo: "术士装备",
};

const ITEM_CATEGORY_LABEL: Record<string, string> = {
  runes: "符文",
  gems: "宝石",
  misc: "杂物",
};

/** 中文摘要，如「隐藏：普通/扩展 低品质装备」；识别不了就退回规则名。 */
export function summarizeRule(rule: LootRule): string {
  const name =
    typeof rule.name === "string" && rule.name.trim() ? rule.name.trim() : "未命名规则";
  const verb =
    typeof rule.ruleType === "string" ? (RULE_TYPE_LABEL[rule.ruleType] ?? null) : null;
  if (!verb) return name;

  const parts: string[] = [];
  const push = (value: unknown, table: Record<string, string>) => {
    if (!Array.isArray(value)) return;
    const labels = value
      .map((v) => (typeof v === "string" ? table[v] : undefined))
      .filter((v): v is string => !!v);
    if (labels.length > 0) parts.push(labels.join("/"));
  };
  push(rule.equipmentQuality, QUALITY_LABEL);
  push(rule.equipmentRarity, RARITY_LABEL);
  push(rule.equipmentCategory, EQUIP_CATEGORY_LABEL);
  push(rule.itemCategory, ITEM_CATEGORY_LABEL);
  if (rule.filterEtherealSocketed === true) parts.push("仅无形/镶孔");

  if (parts.length === 0) return name;
  return `${verb}：${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Mutations (every write is preceded by an automatic backup)
// ---------------------------------------------------------------------------

/**
 * Toggle rule enabled flags. Reads the raw file, backs it up verbatim,
 * patches only the requested rules' enabled fields, then atomically
 * rewrites (tmp + rename) with the source's BOM / indent / trailing-newline
 * conventions. Runs fine while the game is up — the result reports it so
 * the UI can say the change applies on next launch.
 */
export async function updatePreset(
  file: string,
  changes: { index: number; enabled: boolean }[],
): Promise<{ backedUp: string | null; changed: number; gameRunning: boolean }> {
  const path = await presetPath(file);
  const gameRunning = await isGameRunning();
  let bytes: Uint8Array;
  try {
    bytes = await tjs.readFile(path);
  } catch {
    throw new Error(`预设文件不存在：${file}`);
  }
  const text = new TextDecoder().decode(bytes);
  const parsed = lenientParse(text);
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error("预设 JSON 无法解析，已中止修改");
  }

  const backedUp = await backupCurrent(file);

  let changed = 0;
  for (const c of changes) {
    if (!Number.isInteger(c.index) || c.index < 0 || c.index >= parsed.rules.length) continue;
    const rule = parsed.rules[c.index];
    if (typeof rule === "object" && rule !== null) {
      (rule as Record<string, unknown>).enabled = c.enabled === true;
      changed++;
    }
  }

  const payload = serializePreset(parsed, hasUtf8Bom(bytes), /[\r\n]$/.test(text));
  const root = await saveRoot();
  const tmp = joinPath(root, `${file}.tmp-${Date.now()}`);
  try {
    await tjs.writeFile(tmp, payload);
    await tjs.rename(tmp, path);
  } catch (err) {
    await tjs.remove(tmp).catch(() => undefined);
    throw err;
  }
  return { backedUp, changed, gameRunning };
}

/**
 * Read src, set the internal name field, write to dst (tmp + rename, same
 * formatting as src). Unparseable sources are copied verbatim.
 */
async function writeCopyWithName(src: string, dst: string, newName: string): Promise<void> {
  const bytes = await tjs.readFile(src);
  const text = new TextDecoder().decode(bytes);
  const parsed = lenientParse(text);
  const payload =
    parsed && typeof parsed === "object"
      ? serializePreset({ ...parsed, name: newName }, hasUtf8Bom(bytes), /[\r\n]$/.test(text))
      : bytes;
  const tmp = `${dst}.tmp-${Date.now()}`;
  try {
    await tjs.writeFile(tmp, payload);
    await tjs.rename(tmp, dst);
  } catch (err) {
    await tjs.remove(tmp).catch(() => undefined);
    throw err;
  }
}

export async function duplicatePreset(file: string, newName: string): Promise<{ file: string }> {
  const src = await presetPath(file);
  if (!(await pathExists(src))) throw new Error(`预设文件不存在：${file}`);
  const base = newName.trim();
  if (!isValidPresetBaseName(base)) {
    throw new Error(`非法预设名：${JSON.stringify(newName)}`);
  }
  const root = await saveRoot();
  const target = `${base}${PRESET_EXT}`;
  if (await pathExists(joinPath(root, target))) {
    throw new Error(`已存在同名预设：${target}`);
  }
  await writeCopyWithName(src, joinPath(root, target), base);
  return { file: target };
}

/** 同步改文件名与内部 name 字段（新文件先落地，再删旧文件）。 */
export async function renamePreset(file: string, newName: string): Promise<{ file: string }> {
  const src = await presetPath(file);
  if (!(await pathExists(src))) throw new Error(`预设文件不存在：${file}`);
  const base = newName.trim();
  if (!isValidPresetBaseName(base)) {
    throw new Error(`非法预设名：${JSON.stringify(newName)}`);
  }
  const root = await saveRoot();
  const target = `${base}${PRESET_EXT}`;
  if (target.toLowerCase() === file.toLowerCase()) {
    throw new Error("新旧名称相同");
  }
  if (await pathExists(joinPath(root, target))) {
    throw new Error(`已存在同名预设：${target}`);
  }
  await writeCopyWithName(src, joinPath(root, target), base);
  await tjs.remove(src, { maxRetries: 3, retryDelay: 200 });
  return { file: target };
}

/** 删除前先自动备份（备份随文件留在存档根，可找回）。 */
export async function deletePreset(file: string): Promise<{ backedUp: string | null }> {
  const path = await presetPath(file);
  if (!(await pathExists(path))) throw new Error(`预设文件不存在：${file}`);
  const backedUp = await backupCurrent(file);
  await tjs.remove(path, { maxRetries: 3, retryDelay: 200 });
  return { backedUp };
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

/** Pick a .fltr anywhere, validate it parses, copy into the save root
 *  (" (2)" style suffix on name clash). Returns the new file name. */
export async function importPreset(): Promise<{ file: string | null }> {
  const picked = await pickFile({
    title: "导入掉落过滤预设",
    filterName: "掉落过滤预设",
    pattern: `*${PRESET_EXT}`,
  });
  if (!picked) return { file: null };
  const bytes = await tjs.readFile(picked);
  const parsed = lenientParse(new TextDecoder().decode(bytes));
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error("所选文件不是有效的 .fltr 预设（JSON 无法解析）");
  }
  const root = await saveRoot();
  await tjs.makeDir(root, { recursive: true });
  let name = basename(picked);
  if (!isValidPresetName(name)) {
    const inner =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name.trim()
        : "导入的预设";
    name = `${inner.replace(/[\\/:*?"<>|]/g, "_")}${PRESET_EXT}`;
  }
  const stem = name.slice(0, -PRESET_EXT.length);
  let candidate = name;
  for (let i = 2; await pathExists(joinPath(root, candidate)); i++) {
    candidate = `${stem} (${i})${PRESET_EXT}`;
  }
  await tjs.writeFile(joinPath(root, candidate), bytes);
  return { file: candidate };
}

/** Save-dialog export: pick a target path, copy the preset there. */
export async function exportPreset(file: string): Promise<{ path: string | null }> {
  const src = await presetPath(file);
  if (!(await pathExists(src))) throw new Error(`预设文件不存在：${file}`);
  const picked = await pickFile({
    title: "导出掉落过滤预设",
    filterName: "掉落过滤预设",
    pattern: `*${PRESET_EXT}`,
    save: true,
    defaultName: file,
  });
  if (!picked) return { path: null };
  await tjs.copyFile(src, picked);
  return { path: picked };
}
