/**
 * All d2r:* commands. Phantom types in defineCommand are inlined verbatim
 * into the codegen output (src/ztron-commands.ts has no imports), so every
 * args/result `as` type must be self-contained — no named-type references.
 */
import { defineCommand } from "@zturnlibs/ztron-core";
import {
  loadConfig,
  updateConfig,
  newId,
  type KnownMod,
  type LaunchProfile,
} from "./services/config.js";
import {
  validateGameDir,
  ensureModsDir,
  saveRoot,
  modSaveDir,
  pathExists,
  isValidModName,
} from "./services/paths.js";
import { scanSource } from "./services/scan.js";
import { findReadme } from "./services/modinfo.js";
import {
  pickFolder,
  pickFile,
  launchGame,
  exportShortcut,
  openInExplorer,
} from "./services/launch.js";
import {
  installMod,
  uninstallPreflight,
  uninstallModDir,
  installState,
  type InstallProgress,
} from "./services/install.js";
import {
  scanSaveOverview,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup as deleteBackupById,
  setBackupNote as setBackupNoteById,
  isGameRunning,
  isSaveSlot,
  listCharacters,
  transferCharacters,
} from "./services/saves.js";
import { stashPreflight, stashReplace, isStashSlot } from "./services/stash.js";
import {
  scanModScripts,
  runModScript,
  type ScriptRunLine,
} from "./services/authscripts.js";

// ---------------------------------------------------------------------------
// DTO mapper (phantom types in defineCommand stay inline per codegen rules).
// ---------------------------------------------------------------------------

function toModDto(m: KnownMod): {
  key: string;
  name: string;
  displayName: string | null;
  savepath: string;
  sourceId: string;
  sourcePath: string;
  relPath: string;
  variant: string;
  parseWarning: string | null;
  readmePath: string | null;
} {
  return {
    key: m.key,
    name: m.name,
    displayName: m.displayName,
    savepath: m.savepath,
    sourceId: m.sourceId,
    sourcePath: m.sourcePath,
    relPath: m.relPath,
    variant: m.variant,
    parseWarning: m.parseWarning,
    readmePath: m.readmePath,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const getConfig = defineCommand("d2r:getConfig", {
  args: {} as Record<string, never>,
  result: {} as {
    config: {
      version: number;
      gameDir: string | null;
      sources: { id: string; path: string; label: string; addedAt: number }[];
      knownMods: {
        key: string;
        name: string;
        displayName: string | null;
        savepath: string;
        sourceId: string;
        sourcePath: string;
        relPath: string;
        variant: string;
        parseWarning: string | null;
        readmePath: string | null;
      }[];
      profiles: { id: string; name: string; modName: string; extraArgs: string[]; note: string; createdAt: number }[];
      installed: Record<string, { mode: string; installedAt: number; sourcePath: string }>;
      autoBackup: boolean;
      backupKeep: number;
    };
    validation: { exists: boolean; hasD2R: boolean; hasModsDir: boolean } | null;
  },
  handler: async () => {
    const config = await loadConfig();
    return {
      config: {
        version: config.version,
        gameDir: config.gameDir,
        sources: config.sources,
        knownMods: config.knownMods.map(toModDto),
        profiles: config.profiles,
        installed: config.installed,
        autoBackup: config.autoBackup,
        backupKeep: config.backupKeep,
      },
      validation: config.gameDir ? await validateGameDir(config.gameDir) : null,
    };
  },
});

const setGameDir = defineCommand("d2r:setGameDir", {
  args: {} as { gameDir: string },
  result: {} as { ok: boolean; validation: { exists: boolean; hasD2R: boolean; hasModsDir: boolean } },
  handler: async (args) => {
    const gameDir = args.gameDir.trim();
    if (!gameDir) throw new Error("游戏目录不能为空");
    const validation = await validateGameDir(gameDir);
    if (!validation.exists) throw new Error(`目录不存在：${gameDir}`);
    if (!validation.hasD2R) throw new Error(`该目录下没有 D2R.exe：${gameDir}`);
    await ensureModsDir(gameDir);
    const final = await updateConfig((cfg) => ({ ...cfg, gameDir }));
    return { ok: true, validation: await validateGameDir(final.gameDir!) };
  },
});

const pickFolderCmd = defineCommand("d2r:pickFolder", {
  args: {} as { title?: string },
  result: {} as { path: string | null },
  handler: async (args) => {
    const path = await pickFolder(args.title?.trim() || "选择目录");
    return { path };
  },
});

const addSource = defineCommand("d2r:addSource", {
  args: {} as { path: string; label?: string },
  result: {} as {
    source: { id: string; path: string; label: string; addedAt: number };
  },
  handler: async (args) => {
    const path = args.path.trim();
    if (!path) throw new Error("目录不能为空");
    let isDir = false;
    try {
      isDir = (await tjs.stat(path)).isDirectory;
    } catch {
      /* below */
    }
    if (!isDir) throw new Error(`不是有效目录：${path}`);
    const config = await loadConfig();
    const existing = config.sources.find((s) => s.path.toLowerCase() === path.toLowerCase());
    if (existing) return { source: existing };
    const source = {
      id: newId("src"),
      path,
      label: args.label?.trim() || path.split(/[\\/]/).filter(Boolean).pop() || path,
      addedAt: Date.now(),
    };
    await updateConfig((cfg) => ({ ...cfg, sources: [...cfg.sources, source] }));
    return { source };
  },
});

const removeSource = defineCommand("d2r:removeSource", {
  args: {} as { id: string },
  result: {} as { ok: boolean },
  handler: async (args) => {
    await updateConfig((cfg) => ({
      ...cfg,
      sources: cfg.sources.filter((s) => s.id !== args.id),
      knownMods: cfg.knownMods.filter((m) => m.sourceId !== args.id),
    }));
    return { ok: true };
  },
});

const scanSourceCmd = defineCommand("d2r:scanSource", {
  args: {} as { id: string },
  result: {} as {
    mods: {
      key: string;
      name: string;
      displayName: string | null;
      savepath: string;
      sourceId: string;
      sourcePath: string;
      relPath: string;
      variant: string;
      parseWarning: string | null;
      readmePath: string | null;
    }[];
    warnings: string[];
    scannedDirs: number;
  },
  handler: async (args) => {
    const config = await loadConfig();
    const source = config.sources.find((s) => s.id === args.id);
    if (!source) throw new Error("源不存在，请刷新后重试");
    const outcome = await scanSource(source.path, source.id);
    const withReadme = await Promise.all(
      outcome.mods.map(async (m) => ({ ...m, readmePath: await findReadme(m.sourcePath) })),
    );
    await updateConfig((cfg) => ({
      ...cfg,
      knownMods: [
        ...cfg.knownMods.filter((m) => m.sourceId !== source.id),
        ...withReadme,
      ],
    }));
    return { mods: withReadme.map(toModDto), warnings: outcome.warnings, scannedDirs: outcome.scannedDirs };
  },
});

const listMods = defineCommand("d2r:listMods", {
  args: {} as Record<string, never>,
  result: {} as {
    mods: {
      key: string;
      name: string;
      displayName: string | null;
      savepath: string;
      sourceId: string;
      sourcePath: string;
      relPath: string;
      variant: string;
      parseWarning: string | null;
      readmePath: string | null;
    }[];
    installed: Record<string, boolean>;
    suggestedArgs: Record<string, string[]>;
  },
  handler: async () => {
    const config = await loadConfig();
    if (!config.gameDir) return { mods: config.knownMods.map(toModDto), installed: {}, suggestedArgs: {} };
    const installed: Record<string, boolean> = {};
    const suggestedArgs: Record<string, string[]> = {};
    await Promise.all(
      config.knownMods.map(async (m) => {
        installed[m.name] = await installState(config.gameDir!, m.name);
        suggestedArgs[m.name] =
          m.savepath.trim() === "../" ? ["-mod", m.name] : ["-mod", m.name, "-txt"];
      }),
    );
    return { mods: config.knownMods.map(toModDto), installed, suggestedArgs };
  },
});

const installModCmd = defineCommand("d2r:installMod", {
  args: {} as { key: string; mode: string; overwrite: boolean; ch: string },
  result: {} as { ok: boolean; files: number; bytes: number; mode: string; errors: string[] },
  handler: async (args, ctx) => {
    const channel = args.ch as unknown as { kind: "channel"; id: number };
    const handle = ctx.getChannel(channel.id);
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    const mod = config.knownMods.find((m) => m.key === args.key);
    if (!mod) throw new Error("MOD 不存在，请重新扫描");
    const mode = args.mode === "hardlink" ? "hardlink" : "copy";

    try {
      const outcome = await installMod({
        gameDir: config.gameDir,
        sourcePath: mod.sourcePath,
        modName: mod.name,
        mode,
        overwrite: args.overwrite,
        onProgress: (p: InstallProgress) => handle?.send(p),
      });
      await updateConfig((cfg) => ({
        ...cfg,
        installed: {
          ...cfg.installed,
          [mod.name]: { mode: outcome.mode, installedAt: Date.now(), sourcePath: mod.sourcePath },
        },
      }));
      handle?.send({ type: "done", ...outcome });
      return outcome;
    } finally {
      handle?.end();
    }
  },
});

const uninstallPreflightCmd = defineCommand("d2r:uninstallPreflight", {
  args: {} as { name: string },
  result: {} as {
    installed: boolean;
    savepath: string | null;
    usesRootSaves: boolean;
    saveDir: string | null;
    saveDirExists: boolean;
  },
  handler: async (args) => {
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    return uninstallPreflight(config.gameDir, args.name);
  },
});

const uninstallModCmd = defineCommand("d2r:uninstallMod", {
  args: {} as { name: string },
  result: {} as { ok: boolean },
  handler: async (args) => {
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    await uninstallModDir(config.gameDir, args.name);
    await updateConfig((cfg) => {
      const installed = { ...cfg.installed };
      delete installed[args.name];
      return { ...cfg, installed };
    });
    return { ok: true };
  },
});

const readTextB64 = defineCommand("d2r:readTextB64", {
  args: {} as { path: string },
  result: {} as { b64: string | null; size: number },
  handler: async (args) => {
    let size = 0;
    try {
      const st = await tjs.stat(args.path);
      if (!st.isFile) return { b64: null, size: 0 };
      size = st.size;
    } catch {
      return { b64: null, size: 0 };
    }
    if (size > 2 * 1024 * 1024) return { b64: null, size };
    const bytes = await tjs.readFile(args.path);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { b64: btoa(binary), size };
  },
});

const saveProfilesCmd = defineCommand("d2r:saveProfiles", {
  args: {} as {
    profiles: { id: string; name: string; modName: string; extraArgs: string[]; note: string; createdAt: number }[];
  },
  result: {} as {
    profiles: { id: string; name: string; modName: string; extraArgs: string[]; note: string; createdAt: number }[];
  },
  handler: async (args) => {
    const incoming = args.profiles;
    if (!Array.isArray(incoming)) throw new Error("profiles 必须是数组");
    for (const p of incoming) {
      if (!p.id || !p.name?.trim() || !p.modName?.trim()) {
        throw new Error("配置档缺少 id / 名称 / MOD");
      }
      if (!Array.isArray(p.extraArgs) || p.extraArgs.some((a) => typeof a !== "string")) {
        throw new Error(`配置档 ${p.name} 的参数格式不正确`);
      }
    }
    const profiles: LaunchProfile[] = incoming.map((p) => ({
      id: p.id,
      name: p.name.trim(),
      modName: p.modName.trim(),
      extraArgs: p.extraArgs,
      note: p.note ?? "",
      createdAt: p.createdAt || Date.now(),
    }));
    const cfg = await updateConfig((c) => ({ ...c, profiles }));
    return { profiles: cfg.profiles };
  },
});

const launch = defineCommand("d2r:launch", {
  args: {} as { modName: string; extraArgs: string[] },
  result: {} as { pid: number; args: string[] },
  handler: async (args) => {
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    const modName = args.modName.trim();
    if (!modName) throw new Error("未指定要启动的 MOD");
    if (!(await installState(config.gameDir, modName))) {
      throw new Error(`MOD 未安装：${modName}（请先在 MOD 卡片上安装）`);
    }
    const extra = Array.isArray(args.extraArgs) ? args.extraArgs.filter((a) => a.length > 0) : [];
    const launchArgs = ["-mod", modName, ...extra];

    // Silent pre-launch snapshot (never blocks playing): root saves always,
    // plus the mod's own save dir when it already exists on disk.
    if (config.autoBackup) {
      try {
        const saveDir = await saveRoot();
        const mod = config.knownMods.find((m) => m.name === modName);
        const slots = ["root"];
        if (mod && mod.savepath.trim() !== "../") {
          if (await pathExists(await modSaveDir(mod.savepath))) {
            slots.push(`mods/${modName}`);
          }
        }
        const backup = await createBackup({
          saveDir,
          slots,
          note: `启动 ${modName} 前自动备份`,
          trigger: "auto-launch",
          backupKeep: config.backupKeep,
        });
        console.log(`[d2rbox] auto backup ${backup.id} (${backup.files} files) before launch`);
      } catch (err) {
        console.warn("[d2rbox] auto backup failed (launch continues):", err);
      }
    }

    const { pid } = await launchGame(config.gameDir, launchArgs);
    console.log(`[d2rbox] launched D2R.exe pid=${pid} args=${JSON.stringify(launchArgs)}`);
    return { pid, args: launchArgs };
  },
});

const exportShortcutCmd = defineCommand("d2r:exportShortcut", {
  args: {} as { name: string; modName: string; extraArgs: string[] },
  result: {} as { lnkPath: string },
  handler: async (args) => {
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    const modName = args.modName.trim();
    if (!modName) throw new Error("未指定 MOD");
    const safeName = args.name.replace(/[\\/:*?"<>|]/g, "_").trim() || modName;
    const extra = Array.isArray(args.extraArgs) ? args.extraArgs.filter((a) => a.length > 0) : [];
    const lnkPath = await exportShortcut({
      fileName: `${safeName}.lnk`,
      targetExe: `${config.gameDir}\\D2R.exe`,
      args: ["-mod", modName, ...extra].join(" "),
      workDir: config.gameDir,
    });
    return { lnkPath };
  },
});

const openDir = defineCommand("d2r:openDir", {
  args: {} as { path: string },
  result: {} as { ok: boolean },
  handler: async (args) => {
    await openInExplorer(args.path);
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// 存档管家 (M2) — overview / snapshot backup / restore
// ---------------------------------------------------------------------------

const saveOverview = defineCommand("d2r:saveOverview", {
  args: {} as Record<string, never>,
  result: {} as {
    root: {
      name: string;
      slot: string;
      path: string;
      exists: boolean;
      files: { name: string; size: number; mtime: number }[];
      dirs: { name: string; files: number; bytes: number }[];
      totalBytes: number;
    };
    mods: {
      name: string;
      slot: string;
      path: string;
      exists: boolean;
      files: { name: string; size: number; mtime: number }[];
      dirs: { name: string; files: number; bytes: number }[];
      totalBytes: number;
    }[];
  },
  handler: async () => {
    const config = await loadConfig();
    const saveDir = await saveRoot();
    const independent = config.knownMods
      .filter((m) => m.savepath.trim() !== "../" && isValidModName(m.name))
      .map((m) => m.name);
    return scanSaveOverview(saveDir, independent);
  },
});

const listBackupsCmd = defineCommand("d2r:listBackups", {
  args: {} as Record<string, never>,
  result: {} as {
    dir: string;
    backups: {
      id: string;
      createdAt: number;
      note: string;
      trigger: string;
      scopes: { slot: string; sourcePath: string }[];
      files: number;
      bytes: number;
      signature: string;
    }[];
  },
  handler: async () => listBackups(),
});

const backupNow = defineCommand("d2r:backupNow", {
  args: {} as { slots: string[]; note?: string },
  result: {} as {
    backup: {
      id: string;
      createdAt: number;
      note: string;
      trigger: string;
      scopes: { slot: string; sourcePath: string }[];
      files: number;
      bytes: number;
      signature: string;
    };
  },
  handler: async (args) => {
    const slots = Array.isArray(args.slots) ? args.slots : [];
    for (const s of slots) {
      if (!isSaveSlot(s)) throw new Error(`非法存档范围：${s}`);
    }
    const config = await loadConfig();
    const backup = await createBackup({
      saveDir: await saveRoot(),
      slots,
      note: args.note,
      trigger: "manual",
      backupKeep: config.backupKeep,
    });
    return { backup };
  },
});

const restoreBackupCmd = defineCommand("d2r:restoreBackup", {
  args: {} as { id: string },
  result: {} as { ok: boolean; preRestoreId: string | null },
  handler: async (args) => {
    const config = await loadConfig();
    return restoreBackup({ id: args.id, saveDir: await saveRoot(), backupKeep: config.backupKeep });
  },
});

const deleteBackup = defineCommand("d2r:deleteBackup", {
  args: {} as { id: string },
  result: {} as { ok: boolean },
  handler: async (args) => {
    await deleteBackupById(args.id);
    return { ok: true };
  },
});

const setBackupNote = defineCommand("d2r:setBackupNote", {
  args: {} as { id: string; note: string },
  result: {} as { ok: boolean },
  handler: async (args) => {
    await setBackupNoteById(args.id, args.note ?? "");
    return { ok: true };
  },
});

const setSavePrefs = defineCommand("d2r:setSavePrefs", {
  args: {} as { autoBackup?: boolean; backupKeep?: number },
  result: {} as { ok: boolean; autoBackup: boolean; backupKeep: number },
  handler: async (args) => {
    if (args.autoBackup !== undefined && typeof args.autoBackup !== "boolean") {
      throw new Error("autoBackup 必须是布尔值");
    }
    if (args.backupKeep !== undefined) {
      if (!Number.isInteger(args.backupKeep) || args.backupKeep < 1 || args.backupKeep > 100) {
        throw new Error("保留份数需为 1-100 的整数");
      }
    }
    const cfg = await updateConfig((c) => ({
      ...c,
      autoBackup: args.autoBackup ?? c.autoBackup,
      backupKeep: args.backupKeep ?? c.backupKeep,
    }));
    return { ok: true, autoBackup: cfg.autoBackup, backupKeep: cfg.backupKeep };
  },
});

const checkGameRunning = defineCommand("d2r:checkGameRunning", {
  args: {} as Record<string, never>,
  result: {} as { running: boolean },
  handler: async () => ({ running: await isGameRunning() }),
});

const stashPickFile = defineCommand("d2r:stashPickFile", {
  args: {} as { title?: string },
  result: {} as { path: string | null },
  handler: async (args) => {
    const path = await pickFile({
      title: args.title?.trim() || "选择 .d2i 共享仓库文件",
      filterName: "仓库文件",
      pattern: "*.d2i",
    });
    return { path };
  },
});

const stashPreflightCmd = defineCommand("d2r:stashPreflight", {
  args: {} as { slot: string },
  result: {} as {
    slot: string;
    fileName: string;
    path: string;
    exists: boolean;
    size: number;
    mtime: number;
    gameRunning: boolean;
  },
  handler: async (args) => {
    if (!isStashSlot(args.slot)) throw new Error(`非法仓库槽位：${args.slot}`);
    return stashPreflight(await saveRoot(), args.slot);
  },
});

const stashReplaceCmd = defineCommand("d2r:stashReplace", {
  args: {} as { slot: string; sourcePath: string; note?: string },
  result: {} as { ok: boolean; backupId: string | null; replaced: boolean },
  handler: async (args) => {
    if (!isStashSlot(args.slot)) throw new Error(`非法仓库槽位：${args.slot}`);
    const config = await loadConfig();
    return stashReplace({
      saveDir: await saveRoot(),
      slot: args.slot,
      sourcePath: args.sourcePath,
      note: args.note,
      backupKeep: config.backupKeep,
    });
  },
});

// ---------------------------------------------------------------------------
// 作者脚本 (M3) — mods\<mod>\ 顶层 bat 的扫描与受控运行
// ---------------------------------------------------------------------------

const modScripts = defineCommand("d2r:modScripts", {
  args: {} as Record<string, never>,
  result: {} as {
    mods: {
      mod: string;
      scripts: {
        name: string;
        path: string;
        size: number;
        mtime: number;
        sideEffects: { killsGame: boolean; launchesGame: boolean; pauses: boolean };
        missingTargets: string[];
        truncated: boolean;
        b64: string;
      }[];
    }[];
  },
  handler: async () => {
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    const installed: string[] = [];
    for (const m of config.knownMods) {
      if (await installState(config.gameDir, m.name)) installed.push(m.name);
    }
    return scanModScripts(config.gameDir, installed);
  },
});

const runScript = defineCommand("d2r:runScript", {
  args: {} as { modName: string; fileName: string; ch: string },
  result: {} as { ok: boolean; code: number | null; timedOut: boolean },
  handler: async (args, ctx) => {
    const channel = args.ch as unknown as { kind: "channel"; id: number };
    const handle = ctx.getChannel(channel.id);
    const config = await loadConfig();
    if (!config.gameDir) throw new Error("请先在设置中配置游戏目录");
    try {
      const r = await runModScript({
        gameDir: config.gameDir,
        modName: args.modName,
        fileName: args.fileName,
        onLine: (l: ScriptRunLine) => handle?.send(l),
      });
      return { ok: true, code: r.code, timedOut: r.timedOut };
    } finally {
      handle?.end();
    }
  },
});

// ---------------------------------------------------------------------------
// 存档转移 (M3) — 主存档 ↔ mod 存档之间的角色搬移
// ---------------------------------------------------------------------------

const listCharactersCmd = defineCommand("d2r:listCharacters", {
  args: {} as { slot: string },
  result: {} as {
    slot: string;
    path: string;
    exists: boolean;
    characters: {
      name: string;
      d2sName: string;
      size: number;
      mtime: number;
      companions: { name: string; size: number }[];
    }[];
  },
  handler: async (args) => {
    if (!isSaveSlot(args.slot)) throw new Error(`非法存档范围：${args.slot}`);
    return listCharacters(await saveRoot(), args.slot);
  },
});

const transferCharactersCmd = defineCommand("d2r:transferCharacters", {
  args: {} as {
    fromSlot: string;
    toSlot: string;
    names: string[];
    mode: string;
  },
  result: {} as {
    ok: boolean;
    backupId: string | null;
    characters: number;
    files: number;
    mode: string;
  },
  handler: async (args) => {
    const config = await loadConfig();
    return transferCharacters({
      saveDir: await saveRoot(),
      fromSlot: args.fromSlot,
      toSlot: args.toSlot,
      names: Array.isArray(args.names) ? args.names : [],
      mode: args.mode === "move" ? "move" : "copy",
      backupKeep: config.backupKeep,
    });
  },
});

/** All command defs, individually typed — register each via app.commandDef
 *  (a heterogeneous array would collapse the phantom types to a union). */
export const commandDefs = {
  getConfig,
  setGameDir,
  pickFolder: pickFolderCmd,
  addSource,
  removeSource,
  scanSource: scanSourceCmd,
  listMods,
  installMod: installModCmd,
  uninstallPreflight: uninstallPreflightCmd,
  uninstallMod: uninstallModCmd,
  readTextB64,
  saveProfiles: saveProfilesCmd,
  launch,
  exportShortcut: exportShortcutCmd,
  openDir,
  saveOverview,
  listBackups: listBackupsCmd,
  backupNow,
  restoreBackup: restoreBackupCmd,
  deleteBackup,
  setBackupNote,
  setSavePrefs,
  checkGameRunning,
  stashPickFile,
  stashPreflight: stashPreflightCmd,
  stashReplace: stashReplaceCmd,
  modScripts,
  runScript,
  listCharacters: listCharactersCmd,
  transferCharacters: transferCharactersCmd,
};
