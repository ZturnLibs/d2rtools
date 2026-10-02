/**
 * 存档管家: snapshot backup / mirror restore over the D2R save tree.
 *
 * Slot model — a snapshot covers one or more "slots":
 *   "root"        the whole save root dir (recursive), EXCLUDING mods\
 *   "mods/<name>" one per-mod save dir under saveRoot\mods\ (recursive)
 * The whole-dir copy is deliberate: the save tree is tiny (<2MB observed),
 * and copying everything has zero classification edge cases. Restore is a
 * mirror (clear target first, then copy back) with mods\ protected on the
 * root slot, so a restore is a true rollback; the mandatory pre-restore
 * snapshot is the undo path.
 *
 * Every function takes an explicit saveDir so headless probes can exercise
 * the full flow against a sandbox dir — commands pass the real saveRoot().
 */
import {
  joinPath,
  isValidModName,
  pathExists,
} from "./paths.js";
import { configDir, newId } from "./config.js";
import { runPowerShell, parseOkMarker } from "./ps.js";

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

export type SaveSlot = string; // "root" | "mods/<valid name>"

export function isSaveSlot(slot: string): slot is SaveSlot {
  if (slot === "root") return true;
  const m = /^mods\/(.+)$/.exec(slot);
  return m !== null && m[1] !== undefined && isValidModName(m[1]);
}

export function slotSourcePath(saveDir: string, slot: SaveSlot): string {
  if (slot === "root") return saveDir;
  const name = slot.slice("mods/".length);
  return joinPath(saveDir, "mods", name);
}

/** Safe single path segment for the snapshot's slots\<dir>. */
function slotSegment(slot: SaveSlot): string {
  return slot === "root" ? "root" : slot.slice("mods/".length);
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

export type BackupTrigger = "manual" | "auto-launch" | "pre-restore" | "stash";

export interface BackupMeta {
  id: string;
  createdAt: number;
  note: string;
  trigger: BackupTrigger;
  scopes: { slot: SaveSlot; sourcePath: string }[];
  files: number;
  bytes: number;
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

export async function listBackups(): Promise<{ dir: string; backups: BackupMeta[] }> {
  const root = backupsRoot();
  const out: BackupMeta[] = [];
  if (!(await pathExists(root))) return { dir: root, backups: out };
  const d = await tjs.readDir(root);
  for await (const e of d) {
    if (!e.isDirectory || !/^[A-Za-z0-9_-]+$/.test(e.name)) continue;
    try {
      const raw = await tjs.readFile(joinPath(root, e.name, "meta.json"));
      out.push(JSON.parse(new TextDecoder().decode(raw)) as BackupMeta);
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
}): Promise<BackupMeta> {
  const slots = [...new Set(opts.slots)];
  if (slots.length === 0) throw new Error("未选择要备份的存档范围");
  for (const s of slots) {
    if (!isSaveSlot(s)) throw new Error(`非法存档范围：${s}`);
  }

  const resolved: { slot: SaveSlot; sourcePath: string }[] = [];
  for (const slot of slots) {
    const p = slotSourcePath(opts.saveDir, slot);
    if (!(await pathExists(p))) {
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
      const out = await copyTree(
        r.sourcePath,
        joinPath(dir, "slots", slotSegment(r.slot)),
        r.slot === "root" ? ["mods"] : [],
      );
      files += out.files;
      bytes += out.bytes;
    }
    const meta: BackupMeta = {
      id,
      createdAt: Date.now(),
      note: opts.note?.trim() ?? "",
      trigger: opts.trigger,
      scopes: resolved,
      files,
      bytes,
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
    const dst = slotSourcePath(opts.saveDir, s.slot);
    const src = joinPath(dir, "slots", slotSegment(s.slot));
    if (!(await pathExists(src))) {
      throw new Error(`快照缺少槽内容，备份可能不完整：${s.slot}`);
    }
    await mirrorInto(src, dst, s.slot === "root" ? ["mods"] : []);
  }
  return { ok: true, preRestoreId };
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
