/**
 * 存档管家: snapshot backup / mirror restore over the D2R save tree.
 *
 * Slot model — a snapshot covers one or more "slots":
 *   "root"        the whole save root dir (recursive), EXCLUDING mods\
 *   "mods/<name>" one per-mod save dir under saveRoot\mods\ (recursive)
 *   "config"      a manifest pseudo-slot: only Settings.json,
 *                 lootfilter.json and top-level *.fltr — never characters
 * The whole-dir copy is deliberate: the save tree is tiny (<2MB observed),
 * and copying everything has zero classification edge cases. Restore is a
 * mirror (clear target first, then copy back) with mods\ protected on the
 * root slot, so a restore is a true rollback; the mandatory pre-restore
 * snapshot is the undo path. The config slot is the exception: it overlays
 * just the manifest files and never touches characters.
 *
 * Storage format (M6): each slot lands either as slots\<seg>\ (folder) or
 * slots\<seg>.zip, chosen per backup via `zip`; restore probes which one
 * exists. The config slot only ever contains the manifest files, in both
 * formats.
 *
 * Every function takes an explicit saveDir so headless probes can exercise
 * the full flow against a sandbox dir — commands pass the real saveRoot().
 */
import {
  joinPath,
  isValidModName,
  pathExists,
} from "./paths.js";
import { zipDir, unzipToDir } from "./zip.js";
import { configDir, newId } from "./config.js";
import { runPowerShell, parseOkMarker } from "./ps.js";

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export type SaveSlot = string; // "root" | "mods/<valid name>" | "config"

export function isSaveSlot(slot: string): slot is SaveSlot {
  if (slot === "root" || slot === "config") return true;
  const m = /^mods\/(.+)$/.exec(slot);
  return m !== null && m[1] !== undefined && isValidModName(m[1]);
}

export function slotSourcePath(saveDir: string, slot: SaveSlot): string {
  if (slot === "root" || slot === "config") return saveDir;
  const name = slot.slice("mods/".length);
  return joinPath(saveDir, "mods", name);
}

/** Safe single path segment for the snapshot's slots\<dir>. */
function slotSegment(slot: SaveSlot): string {
  return slot === "root" ? "root" : slot === "config" ? "config" : slot.slice("mods/".length);
}

// ---------------------------------------------------------------------------
// Config manifest (pseudo-slot collection semantics — inclusion, not tree)
// ---------------------------------------------------------------------------

/** Lower-cased top-level names always in the config manifest. */
const CONFIG_MANIFEST_NAMES = new Set(["settings.json", "lootfilter.json"]);

/** Top-level manifest files of the save root: Settings.json,
 *  lootfilter.json, *.fltr. Never recurses, never touches .d2s. */
async function listConfigManifestFiles(saveDir: string): Promise<string[]> {
  const out: string[] = [];
  const d = await tjs.readDir(saveDir);
  for await (const e of d) {
    if (!e.isFile) continue;
    const lower = e.name.toLowerCase();
    if (CONFIG_MANIFEST_NAMES.has(lower) || lower.endsWith(".fltr")) out.push(e.name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function copyConfigManifest(
  saveDir: string,
  dstDir: string,
): Promise<{ files: number; bytes: number }> {
  const names = await listConfigManifestFiles(saveDir);
  await tjs.makeDir(dstDir, { recursive: true });
  let bytes = 0;
  for (const n of names) {
    const src = joinPath(saveDir, n);
    const st = await tjs.stat(src);
    await tjs.copyFile(src, joinPath(dstDir, n));
    bytes += st.size;
  }
  return { files: names.length, bytes };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface SaveFileEntry {
  name: string;
  size: number;
  /** epoch ms; 0 when unknown */
  mtime: number;
}

export interface SaveDirEntry {
  name: string;
  files: number;
  bytes: number;
}

export interface SaveGroup {
  /** "主存档" or the mod save dir name */
  name: string;
  slot: SaveSlot;
  path: string;
  exists: boolean;
  files: SaveFileEntry[];
  dirs: SaveDirEntry[];
  totalBytes: number;
}

/** Root-level dirs to surface in the overview (everything except mods\). */
async function listSubdirs(dir: string): Promise<SaveDirEntry[]> {
  const d = await tjs.readDir(dir);
  const out: SaveDirEntry[] = [];
  for await (const e of d) {
    if (!e.isDirectory) continue;
    if (e.name.toLowerCase() === "mods") continue;
    const sub = joinPath(dir, e.name);
    let files = 0;
    let bytes = 0;
    for (const f of await walkFiles(sub)) {
      files++;
      bytes += f.size;
    }
    out.push({ name: e.name, files, bytes });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function statFiles(dir: string): Promise<SaveFileEntry[]> {
  const d = await tjs.readDir(dir);
  const out: SaveFileEntry[] = [];
  for await (const e of d) {
    if (!e.isFile) continue;
    let size = 0;
    let mtime = 0;
    try {
      const st = await tjs.stat(joinPath(dir, e.name));
      size = st.size;
      mtime = st.mtim instanceof Date ? st.mtim.getTime() : 0;
    } catch {
      /* raced delete — report zeros */
    }
    out.push({ name: e.name, size, mtime });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanSaveOverview(
  saveDir: string,
  knownModSaveNames: string[],
): Promise<{ root: SaveGroup; mods: SaveGroup[] }> {
  const rootExists = await pathExists(saveDir);

  const root: SaveGroup = {
    name: "主存档",
    slot: "root",
    path: saveDir,
    exists: rootExists,
    files: [],
    dirs: [],
    totalBytes: 0,
  };
  if (rootExists) {
    root.files = await statFiles(saveDir);
    root.dirs = await listSubdirs(saveDir);
    root.totalBytes =
      root.files.reduce((n, f) => n + f.size, 0) +
      root.dirs.reduce((n, d) => n + d.bytes, 0);
  }

  // Live dirs under mods\ plus every known independent mod savepath — the
  // union, so a registered mod whose save dir is not created yet still shows.
  const names = new Set<string>(knownModSaveNames);
  const modsDir = joinPath(saveDir, "mods");
  if (await pathExists(modsDir)) {
    const d = await tjs.readDir(modsDir);
    for await (const e of d) {
      if (e.isDirectory && isValidModName(e.name)) names.add(e.name);
    }
  }
  const mods: SaveGroup[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const path = joinPath(saveDir, "mods", name);
    const exists = await pathExists(path);
    const group: SaveGroup = {
      name,
      slot: `mods/${name}`,
      path,
      exists,
      files: [],
      dirs: [],
      totalBytes: 0,
    };
    if (exists) {
      group.files = await statFiles(path);
      group.totalBytes = group.files.reduce((n, f) => n + f.size, 0);
    }
    mods.push(group);
  }

  return { root, mods };
}

// ---------------------------------------------------------------------------
// Backup store: %APPDATA%\com.zyj.d2rbox\backups\<id>\{meta.json, slots\}
// ---------------------------------------------------------------------------

export type BackupTrigger = "manual" | "auto-launch" | "pre-restore" | "stash" | "transfer";

export interface BackupMeta {
  id: string;
  createdAt: number;
  note: string;
  trigger: BackupTrigger;
  scopes: { slot: SaveSlot; sourcePath: string }[];
  files: number;
  bytes: number;
  /** sum of file sizes in the snapshot payload */
  size: number;
  /** storage format: every slot stored as slots\<seg>.zip */
  zip: boolean;
  /** sorted slot signature — prune keeps N per signature */
  signature: string;
}

export function backupsRoot(): string {
  return joinPath(configDir(), "backups");
}

function backupPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`非法备份 id：${JSON.stringify(id)}`);
  }
  return joinPath(backupsRoot(), id);
}

// ---------------------------------------------------------------------------
// Tree helpers (independent from install.ts — different failure semantics:
// a backup walks everything and throws on unreadable dirs, install collects)
// ---------------------------------------------------------------------------

interface WalkedFile {
  path: string;
  rel: string;
  size: number;
}

/**
 * Walk dir recursively. `rel` is the path relative to `dir` ("\\"-separated).
 * `excludeTop` skips top-level dir names (depth 0 only) — the root slot
 * excludes `mods\` this way.
 */
async function walkFiles(dir: string, prefix = "", excludeTop: string[] = []): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const lowerEx = excludeTop.map((n) => n.toLowerCase());
  const atTop = prefix === "";
  const d = await tjs.readDir(dir);
  for await (const e of d) {
    if (atTop && e.isDirectory && lowerEx.includes(e.name.toLowerCase())) continue;
    const p = joinPath(dir, e.name);
    if (e.isDirectory) {
      out.push(...(await walkFiles(p, `${prefix}${e.name}\\`, excludeTop)));
    } else if (e.isFile) {
      let size = 0;
      try {
        size = (await tjs.stat(p)).size;
      } catch {
        /* raced delete */
      }
      out.push({ path: p, rel: `${prefix}${e.name}`, size });
    }
  }
  return out;
}

async function copyTree(srcDir: string, dstDir: string, excludeTop: string[] = []): Promise<{ files: number; bytes: number }> {
  const files = await walkFiles(srcDir, "", excludeTop);
  await tjs.makeDir(dstDir, { recursive: true });
  let bytes = 0;
  for (const f of files) {
    const dst = joinPath(dstDir, f.rel);
    await tjs.makeDir(dst.slice(0, dst.lastIndexOf("\\")), { recursive: true });
    await tjs.copyFile(f.path, dst);
    bytes += f.size;
  }
  return { files: files.length, bytes };
}

/** Empty dstDir, sparing protected child names, then copy src over it. */
async function mirrorInto(srcDir: string, dstDir: string, protect: string[]): Promise<{ files: number; bytes: number }> {
  await tjs.makeDir(dstDir, { recursive: true });
  const lower = protect.map((p) => p.toLowerCase());
  const d = await tjs.readDir(dstDir);
  const doomed: string[] = [];
  for await (const e of d) {
    if (lower.includes(e.name.toLowerCase())) continue;
    doomed.push(joinPath(dstDir, e.name));
  }
  for (const p of doomed) {
    await tjs.remove(p, { recursive: true, maxRetries: 3, retryDelay: 200 });
  }
  return copyTree(srcDir, dstDir);
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

function signatureOf(slots: SaveSlot[]): string {
  return [...slots].sort().join("+");
}

/** Recursive byte total of a backup dir (payload + meta). */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const d = await tjs.readDir(dir);
  for await (const e of d) {
    const p = joinPath(dir, e.name);
    if (e.isDirectory) {
      total += await dirBytes(p);
    } else if (e.isFile) {
      try {
        total += (await tjs.stat(p)).size;
      } catch {
        /* raced delete */
      }
    }
  }
  return total;
}

/** True when every scope of the backup is stored as slots\<seg>.zip. */
async function backupIsZip(root: string, id: string, scopes: BackupMeta["scopes"]): Promise<boolean> {
  for (const s of scopes) {
    if (!(await pathExists(joinPath(root, id, "slots", `${slotSegment(s.slot)}.zip`)))) {
      return false;
    }
  }
  return scopes.length > 0;
}

export async function listBackups(): Promise<{ dir: string; backups: BackupMeta[] }> {
  const root = backupsRoot();
  const out: BackupMeta[] = [];
  if (!(await pathExists(root))) return { dir: root, backups: out };
  const d = await tjs.readDir(root);
  for await (const e of d) {
    if (!e.isDirectory || !/^[A-Za-z0-9_-]+$/.test(e.name)) continue;
    try {
      const raw = await tjs.readFile(joinPath(root, e.name, "meta.json"));
      const meta = JSON.parse(new TextDecoder().decode(raw)) as BackupMeta;
      // size/zip are derived, not trusted from disk — legacy backups lack them.
      meta.size = await dirBytes(joinPath(root, e.name));
      meta.zip = await backupIsZip(root, e.name, meta.scopes ?? []);
      out.push(meta);
    } catch (err) {
      console.warn(`[d2rbox] backup ${e.name} meta unreadable:`, err);
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return { dir: root, backups: out };
}

/** Keep the newest `keep` snapshots per scope signature, delete the rest. */
export async function pruneBackups(keep: number): Promise<void> {
  if (!Number.isFinite(keep) || keep < 1) return;
  const { backups } = await listBackups();
  const seen = new Map<string, number>();
  for (const b of backups) {
    // listBackups is newest-first: the first `keep` of each signature survive.
    const n = (seen.get(b.signature) ?? 0) + 1;
    seen.set(b.signature, n);
    if (n > keep) {
      await tjs.remove(backupPath(b.id), { recursive: true, maxRetries: 3, retryDelay: 200 });
    }
  }
}

export async function createBackup(opts: {
  saveDir: string;
  slots: SaveSlot[];
  note?: string;
  trigger: BackupTrigger;
  backupKeep: number;
  /** true → each slot stored as slots\<seg>.zip (config slot included) */
  zip?: boolean;
}): Promise<BackupMeta> {
  const slots = [...new Set(opts.slots)];
  if (slots.length === 0) throw new Error("未选择要备份的存档范围");
  for (const s of slots) {
    if (!isSaveSlot(s)) throw new Error(`非法存档范围：${s}`);
  }
  const zip = opts.zip === true;

  const resolved: { slot: SaveSlot; sourcePath: string }[] = [];
  for (const slot of slots) {
    const p = slotSourcePath(opts.saveDir, slot);
    if (slot !== "config" && !(await pathExists(p))) {
      throw new Error(`存档目录不存在，无法备份：${p}`);
    }
    resolved.push({ slot, sourcePath: p });
  }

  const id = newId("bak");
  const dir = backupPath(id);
  let files = 0;
  let bytes = 0;
  try {
    for (const r of resolved) {
      const seg = slotSegment(r.slot);
      if (r.slot === "config") {
        // 包含清单语义：无论 zip 与否，只收 Settings.json /
        // lootfilter.json / *.fltr（不递归）。
        if (zip) {
          const stage = joinPath(dir, "slots", `.tmp-config-${Date.now()}`);
          await copyConfigManifest(opts.saveDir, stage);
          const z = await zipDir(stage, joinPath(dir, "slots", `${seg}.zip`));
          await tjs.remove(stage, { recursive: true, maxRetries: 2, retryDelay: 200 });
          files += z.files;
          bytes += z.bytes;
        } else {
          const c = await copyConfigManifest(opts.saveDir, joinPath(dir, "slots", seg));
          files += c.files;
          bytes += c.bytes;
        }
      } else if (zip) {
        const z = await zipDir(
          r.sourcePath,
          joinPath(dir, "slots", `${seg}.zip`),
          { excludeTop: r.slot === "root" ? ["mods"] : [] },
        );
        files += z.files;
        bytes += z.bytes;
      } else {
        const out = await copyTree(
          r.sourcePath,
          joinPath(dir, "slots", seg),
          r.slot === "root" ? ["mods"] : [],
        );
        files += out.files;
        bytes += out.bytes;
      }
    }
    const meta: BackupMeta = {
      id,
      createdAt: Date.now(),
      note: opts.note?.trim() ?? "",
      trigger: opts.trigger,
      scopes: resolved,
      files,
      bytes,
      size: bytes,
      zip,
      signature: signatureOf(slots),
    };
    await tjs.writeFile(joinPath(dir, "meta.json"), JSON.stringify(meta, null, 2));
  } catch (err) {
    // A half-written snapshot is worse than none — clean up on failure.
    await tjs.remove(dir, { recursive: true, maxRetries: 2, retryDelay: 200 }).catch(() => {});
    throw err;
  }
  await pruneBackups(opts.backupKeep);
  const { backups } = await listBackups();
  return backups.find((b) => b.id === id) ?? {
    id,
    createdAt: Date.now(),
    note: opts.note ?? "",
    trigger: opts.trigger,
    scopes: resolved,
    files,
    bytes,
    size: bytes,
    zip,
    signature: signatureOf(slots),
  };
}

export async function deleteBackup(id: string): Promise<void> {
  const dir = backupPath(id);
  if (!(await pathExists(dir))) throw new Error(`备份不存在：${id}`);
  await tjs.remove(dir, { recursive: true, maxRetries: 3, retryDelay: 200 });
}

export async function setBackupNote(id: string, note: string): Promise<void> {
  const metaFile = joinPath(backupPath(id), "meta.json");
  let meta: BackupMeta;
  try {
    const raw = await tjs.readFile(metaFile);
    meta = JSON.parse(new TextDecoder().decode(raw)) as BackupMeta;
  } catch {
    throw new Error(`备份不存在或已损坏：${id}`);
  }
  meta.note = note.trim();
  await tjs.writeFile(metaFile, JSON.stringify(meta, null, 2));
}

export async function restoreBackup(opts: {
  id: string;
  saveDir: string;
  backupKeep: number;
}): Promise<{ ok: boolean; preRestoreId: string | null }> {
  const dir = backupPath(opts.id);
  let meta: BackupMeta;
  try {
    const raw = await tjs.readFile(joinPath(dir, "meta.json"));
    meta = JSON.parse(new TextDecoder().decode(raw)) as BackupMeta;
  } catch {
    throw new Error(`备份不存在或已损坏：${opts.id}`);
  }

  if (await isGameRunning()) {
    throw new Error("D2R.exe 正在运行，请先退出游戏再还原存档");
  }

  // Mandatory undo point: snapshot the current state of every scope that
  // currently exists (all-missing scopes → nothing to protect).
  let preRestoreId: string | null = null;
  const existing = [];
  for (const s of meta.scopes) {
    if (await pathExists(slotSourcePath(opts.saveDir, s.slot))) existing.push(s.slot);
  }
  if (existing.length > 0) {
    const pre = await createBackup({
      saveDir: opts.saveDir,
      slots: existing,
      note: `还原 ${opts.id} 前自动备份`,
      trigger: "pre-restore",
      backupKeep: opts.backupKeep,
    });
    preRestoreId = pre.id;
  }

  for (const s of meta.scopes) {
    const seg = slotSegment(s.slot);

    if (s.slot === "config") {
      // 配置槽例外：不清空、不镜像，只把清单文件覆盖写回存档根，
      // 角色 .d2s 等一律不碰。
      const srcDir = joinPath(dir, "slots", seg);
      const zipFile = `${srcDir}.zip`;
      let manifestDir = srcDir;
      let tempDir: string | null = null;
      if (await pathExists(zipFile)) {
        tempDir = joinPath(dir, "slots", `.tmp-unzip-${seg}-${Date.now()}`);
        await unzipToDir(zipFile, tempDir);
        manifestDir = tempDir;
      } else if (!(await pathExists(srcDir))) {
        throw new Error(`快照缺少槽内容，备份可能不完整：${s.slot}`);
      }
      try {
        for (const name of await listConfigManifestFiles(manifestDir)) {
          await tjs.copyFile(joinPath(manifestDir, name), joinPath(opts.saveDir, name));
        }
      } finally {
        if (tempDir) {
          await tjs.remove(tempDir, { recursive: true, maxRetries: 2, retryDelay: 200 }).catch(() => undefined);
        }
      }
      continue;
    }

    const srcDir = joinPath(dir, "slots", seg);
    const zipFile = `${srcDir}.zip`;
    const dst = slotSourcePath(opts.saveDir, s.slot);
    if (await pathExists(srcDir)) {
      await mirrorInto(srcDir, dst, s.slot === "root" ? ["mods"] : []);
    } else if (await pathExists(zipFile)) {
      // zip 槽：解压到备份目录下的临时目录，再走与文件夹相同的镜像还原。
      const tempDir = joinPath(dir, "slots", `.tmp-unzip-${seg}-${Date.now()}`);
      try {
        await unzipToDir(zipFile, tempDir);
        await mirrorInto(tempDir, dst, s.slot === "root" ? ["mods"] : []);
      } finally {
        await tjs.remove(tempDir, { recursive: true, maxRetries: 2, retryDelay: 200 }).catch(() => undefined);
      }
    } else {
      throw new Error(`快照缺少槽内容，备份可能不完整：${s.slot}`);
    }
  }
  return { ok: true, preRestoreId };
}

// ---------------------------------------------------------------------------
// 角色转移 (M3) — 主存档 ↔ mod 存档之间搬 .d2s 及其伴生文件
// ---------------------------------------------------------------------------

/** 单个合法文件名（路径段），允许空格与中文，拒绝分隔符与 .. */
function isFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/:*?"<>|]/.test(name)
  );
}

/** .d2s 角色的伴生文件后缀（同名 stem） */
const COMPANION_SUFFIXES = [
  ".ctl", ".key", ".ma0", ".ma1", ".ma2", ".ma3", ".map", ".d2s.backup",
] as const;

export interface CharacterInfo {
  /** stem：`Amazon_01.d2s` → `Amazon_01` */
  name: string;
  d2sName: string;
  size: number;
  mtime: number;
  /** 伴生文件名（.ctl/.key/.ma0-3/.map/.d2s.backup） */
  companions: { name: string; size: number }[];
}

/** 列出某存档组里的角色（顶层 .d2s + 同名伴生文件），按名字排序。 */
export async function listCharacters(
  saveDir: string,
  slot: SaveSlot,
): Promise<{ slot: SaveSlot; path: string; exists: boolean; characters: CharacterInfo[] }> {
  if (!isSaveSlot(slot)) throw new Error(`非法存档范围：${slot}`);
  const dir = slotSourcePath(saveDir, slot);
  if (!(await pathExists(dir))) {
    return { slot, path: dir, exists: false, characters: [] };
  }
  const files = await statFiles(dir); // top-level only, sorted
  const byStem = new Map<string, { d2s?: SaveFileEntry; companions: SaveFileEntry[] }>();
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".d2s")) {
      const stem = f.name.slice(0, -4);
      if (!isFileName(stem)) continue;
      const rec = byStem.get(stem) ?? { companions: [] };
      rec.d2s = f;
      byStem.set(stem, rec);
      continue;
    }
    const m = /\.(?:ctl|key|ma[0-3]|map)$/.exec(lower)?.[0]
      ?? (lower.endsWith(".d2s.backup") ? ".d2s.backup" : null);
    if (!m) continue;
    const stem = f.name.slice(0, f.name.length - m.length);
    if (!isFileName(stem) || stem === "") continue;
    const rec = byStem.get(stem) ?? { companions: [] };
    rec.companions.push(f);
    byStem.set(stem, rec);
  }
  const characters: CharacterInfo[] = [];
  for (const [stem, rec] of byStem) {
    if (!rec.d2s) continue; // 孤儿伴生文件（无 .d2s）不作为角色暴露
    characters.push({
      name: stem,
      d2sName: rec.d2s.name,
      size: rec.d2s.size,
      mtime: rec.d2s.mtime,
      companions: rec.companions.map((c) => ({ name: c.name, size: c.size })),
    });
  }
  characters.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return { slot, path: dir, exists: true, characters };
}

export interface TransferResult {
  ok: boolean;
  backupId: string | null;
  characters: number;
  files: number;
  mode: "copy" | "move";
}

/**
 * 在两个存档组之间转移角色（.d2s + 全部同名伴生文件）。写前置：
 * 游戏运行中拒绝；重名冲突拒绝并列出名单；执行前对源/目标两组做
 * trigger="transfer" 的自动快照（回滚点）。move 模式在全部复制成功后
 * 才删除源文件。
 */
export async function transferCharacters(opts: {
  saveDir: string;
  fromSlot: SaveSlot;
  toSlot: SaveSlot;
  names: string[];
  mode: "copy" | "move";
  backupKeep: number;
}): Promise<TransferResult> {
  if (await isGameRunning()) {
    throw new Error("D2R.exe 正在运行，请先退出游戏再转移存档");
  }
  if (!isSaveSlot(opts.fromSlot)) throw new Error(`非法存档范围：${opts.fromSlot}`);
  if (!isSaveSlot(opts.toSlot)) throw new Error(`非法存档范围：${opts.toSlot}`);
  if (opts.fromSlot === opts.toSlot) throw new Error("源存档组与目标存档组相同");
  if (opts.mode !== "copy" && opts.mode !== "move") throw new Error(`非法转移模式：${opts.mode}`);
  const names = [...new Set(opts.names)];
  if (names.length === 0) throw new Error("未选择要转移的角色");
  for (const n of names) {
    if (!isFileName(n)) throw new Error(`非法角色名：${JSON.stringify(n)}`);
  }

  const fromDir = slotSourcePath(opts.saveDir, opts.fromSlot);
  const toDir = slotSourcePath(opts.saveDir, opts.toSlot);
  if (!(await pathExists(fromDir))) throw new Error(`源存档目录不存在：${fromDir}`);
  if (!(await pathExists(toDir))) {
    await tjs.makeDir(toDir, { recursive: true }); // 目标组还没建档 — 建立后照常转移
  }

  // 源组实际文件（顶层），按 stem 归集
  const { characters } = await listCharacters(opts.saveDir, opts.fromSlot);
  const wanted = new Set(names);
  const chosen = characters.filter((c) => wanted.has(c.name));
  const notFound = names.filter((n) => !chosen.some((c) => c.name === n));
  if (notFound.length > 0) {
    throw new Error(`源存档组中找不到角色：${notFound.join("、")}`);
  }

  // 重名冲突：目标组已有同名 .d2s
  const targetChars = await listCharacters(opts.saveDir, opts.toSlot);
  const conflicts = chosen
    .filter((c) => targetChars.characters.some((t) => t.name.toLowerCase() === c.name.toLowerCase()))
    .map((c) => c.name);
  if (conflicts.length > 0) {
    throw new Error(`目标存档组已存在同名角色：${conflicts.join("、")}（请先处理重名）`);
  }

  // 双 scope 预备份（源 + 目标，存在的才拍）— trigger=transfer, 可回滚
  let backupId: string | null = null;
  const existing: SaveSlot[] = [];
  for (const s of [opts.fromSlot, opts.toSlot]) {
    if (await pathExists(slotSourcePath(opts.saveDir, s))) existing.push(s);
  }
  if (existing.length > 0) {
    const backup = await createBackup({
      saveDir: opts.saveDir,
      slots: existing,
      note: `转移角色前自动备份（${opts.mode === "move" ? "移动" : "复制"} ${chosen.length} 个角色）`,
      trigger: "transfer",
      backupKeep: opts.backupKeep,
    });
    backupId = backup.id;
  }

  // 复制（全成功才进 move 删除阶段）
  let files = 0;
  for (const c of chosen) {
    const all = [c.d2sName, ...c.companions.map((x) => x.name)];
    for (const fname of all) {
      await tjs.copyFile(joinPath(fromDir, fname), joinPath(toDir, fname));
      files++;
    }
  }

  if (opts.mode === "move") {
    for (const c of chosen) {
      const all = [c.d2sName, ...c.companions.map((x) => x.name)];
      for (const fname of all) {
        await tjs.remove(joinPath(fromDir, fname), { maxRetries: 3, retryDelay: 200 });
      }
    }
  }

  return {
    ok: true,
    backupId,
    characters: chosen.length,
    files,
    mode: opts.mode,
  };
}

// ---------------------------------------------------------------------------
// Game process detection (write-ops guard)
// ---------------------------------------------------------------------------

export async function isGameRunning(): Promise<boolean> {
  try {
    const r = await runPowerShell({
      command:
        "if (Get-Process -Name 'D2R' -ErrorAction SilentlyContinue) { Write-Output '__D2R_OK__running' } else { Write-Output '__D2R_OK__not' }",
      timeoutMs: 10_000,
    });
    return parseOkMarker(r.stdout) === "running";
  } catch (err) {
    console.warn("[d2rbox] game-process probe failed, assuming not running:", err);
    return false;
  }
}
