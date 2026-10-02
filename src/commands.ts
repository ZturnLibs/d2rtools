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
import { validateGameDir, ensureModsDir } from "./services/paths.js";
import { scanSource } from "./services/scan.js";
import { findReadme } from "./services/modinfo.js";
import { pickFolder, launchGame, exportShortcut, openInExplorer } from "./services/launch.js";
import {
  installMod,
  uninstallPreflight,
  uninstallModDir,
  installState,
  type InstallProgress,
} from "./services/install.js";

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
};
